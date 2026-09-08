"""Pinned Unicode 15.0 canonical normalization for cache path validation."""

from __future__ import annotations

import base64
import zlib
from functools import lru_cache


PINNED_UNICODE_VERSION = "15.0.0"
# Generated from Unicode 15.0 canonical combining/decomposition/composition data.
_COMPRESSED_NORMALIZATION_ROWS = (
    "c-mEcOS&a3h;6^dl8x|fe5ZM905t`}$NYzIfd#n#MxI2Lx)BV;P>lcmo6lbk|I+jP&;KbwtpEAnzZsAW#t+0|enc`FKN5@i3CU#q"
    "L@efKB)joDv6x?w9L68SVt)I}>0gSC`9ctj`TZ{!le0k1&ioh2V0@DEW&S`i8lU7G%>R(=#wU3`=Fh+UTKzBTpUhuK2IEuxi}@SL"
    "Xnd-FGyfpjjZgI-;xE$YHvI@eEasCwkNvI?#A1FzG8jJ)i}@MJX#7Yl<`*QB@u_~+=c-6{<9A{)|NSebPY}dn{y;JqpMID1wmu}I"
    "@#%M2Z)+mijZgKn-q!jnrZ*78BL05<s`WPz#A1FxG8jJ)i}?}BX#7Yl<|ibR@e{F_pONgw@5Ew$L2?*>5R3WkuUdZtK`iF?ziRpc"
    "K`iFKNCxARoUFG!kc`GBIazP}L$Vv6<YB$-`B$yKfgl$17m~sFRKMtLBN>fP^>csQ2gz=Hs-OGYA$?kZ13@h2lRmA#fgl$16OzIB"
    "fmqDXNJisFVllrUnT${Mvp!EnvKzk>i}~+gGkt;}7V`&^!T9vMthe(a8I4cB%X&K#$!>hApY?XuUo*XdAQtlvlHK@}pY;<S9r&^h"
    "K$&@hXjjbERTv3^=-^kaOl6)R+8wKvVI&EH0WjJC7(4R>L6?lyRRt-6R2lp5@C(5_LC{@cCPSJa9a*E5iOdt^Mb>C#7<mO5$ZCTv"
    ")lNJ?K4i7WLXc08iLBGgOy&u)kab!aMwTEnSY|7e71@GN_cf#%BK8Rp<8!uwIx|m@geNK6BgKg5I%H(6R;Dsfkb<n$$}l3j4i#CO"
    "m1)cqq#<jwGK`3>116(rlL%Wbh^_;MhiH$xAfoG_6VkNbnamSJhlpvv!-(iQkgl8Aw83&gbR9_7hEzjD*I^@TwKCjN(RDb;TCEHt"
    "qU-n|YqK(qd4dFFZB~X6c@|=ntkKFuM#MfbN!Dm(1QGj0vQM}6bVwb=K9THWNHs+4LmHHMG}(ljm?y}K5ii-$$B5`U4rI+%CNocv"
    "4_UL7VMKHt)d8qhrZP_u9g?e+VMKHt;RHmR?Ah8;bR97)M;n#}5nZPT)i?W{#ymktJHxaypo1jZNu(V^sv)ACM7{SjD}2y(lHQxB"
    "_Zm_Sk=~ogWtuj+OpGB(^p<E6Go%_KdP|>V#qUh5P4t$gWX10oB6>>;)ld7K$vi<es-N~djELTHf_D_mO$y8tBx4>6HlZ;h+Q~(-"
    "LbeSFvS=q)$qLyF5$)uL>ZkqAWS$@$)ld5!Mx?*x2@fipE0vii$iiHgZPH^zTADYqRx4APC&)q8YGoLa9#S4;{jAK#JV64oepZGN"
    "c^XUpE79Do2<;TnPAPxQkY<Qzr&P%*+5y2lL7HS0q!}XGDIL{M`<=-=L0(ip?ROZFURB7Yv^lHjoK>V(6`JG?X@*FzDic|wm5Iy~"
    "WFc#`GK`3>%a*KYPg1Ex*X2l7w8s$9b$w9%wBMP`6C|MeX}`mW=(@(glI?dgYO6Bx)%4d4X@*Gety!|-cXXbsVxL+hD}Kiiu}|&r"
    "sFS(YiFtykGnLE<VnlRZ)qT%aCNobEb*QqHVMKIY)rGHCrZP{Eg{;-eFe19H8(D{y8O#&pAnUL)jEJt=gRGyG`Isk2K-SO7Fe18c"
    "QL;u`Uhp{DMAt1z)@Y8PAfoF=y0*Eo=-k*u*Nt>-NHauq-6~co(UvQW$g|KI{KjYwBqQ=Hw2rLZ%CH1tpGJ$TVLg7JUpKK&BX`%3"
    "W{B9QeaPCZOk<uP6Iq*;VMOfH7P3w&GnpsIM%HO%7!msnj4r`O7xF%cCkRHDV55s5Vuf);`N1qFh}iUdMESui$H*tO@xnRS2pb@Q"
    "tegWaovR_$5RuIm&(r2cM&x(agQ<7g96XsPNWdUDZM0-Wq+YtznKoK7B7KJz*Tp=pq8^v5t^+Nvn<32*={vN*UQ?eR5X=*#(h@|G"
    "V~F&f)sQt<nZP_jI<f{U!-(`9T9_}J8<)<FvN8{}G(UzML!|G};#{&mR_0-zAQM?1E5nHNowfgFR;fWSPmn`PW<|CkVg*{f$5<6o"
    "in)RX;xxyaVqyte#7`?Wt&~`Tmhsz=ZHQQ6SGc0neA3B0K^k1qX+9|<qE%Y7vlE0epCY1FUbY)j4H2!<!kxQKv=<~ij>yVA@Y3Co"
    "YKUlcbLpXCE5%&F7Uy#8Q%rh3E#kvxqASH*!OmZNZ30z_xs06$Zr?QjZ!%Ai4CMsVQed7S1<DDgB}Sybo(`AiG2iE5o**w=p2vJ2"
    "Mnp@8U(ac6Aebk}_qPq%hKQDEsV>G2W_3nHN3>YqhHOJbLudc3Zcj{CMD#-o`D4g2gtZfGC4X$BIm{D8SMtY38b*R3Sjh)_y%_@Y"
    "1i?x^*o!DZk|4UeJhp=4+Oi<Jx;(amW26Xz)n%~PlTuq11gpznFOmdlg6N9p*eJ-gbwPB+b8Hl3<P`)fo?x#jrM4jmRy@I8C<*cj"
    "qW<i$k&|nif~Y@xY~*BQ2?BpM*lS6tZ3_Z_HrNX!LBu}cfvb4TXFSXkB*0ZX<})%P_Mz23XAS1ha&5BukF@%4hBQOOKD7ETW`&|w"
    "kkx;r)qgXj86x(f)qgQ76t#k^{v)man<32*u@9~O#l5WNXIAD3^1{8W=4Ub@_Mz3kxQf+$Mn=RwG-EbHnjvBzUdeYG&4gf{AP0-&"
    "X{%*MMAuYW9)V`hLSvpF4Ua&xXMquEPt>;=_68&}BJGL#HpAY42qNvF751`m8wB$N`TmX}#}H``t+1DQpdgqh$oe~m97CkPMO{BN"
    ">!U1z=pgF)saYRoM0AjNmfAiOZPX`g?3j3#I*uL1q|c=YH!hn$$B6W~l;HYh^8p!2|MUO;c!cDdnF>xtr;=0Isp3?1syWr2dYu|h"
    "eNIiMmQ&lQV^nbYg3A|NzTol&moF4)HB%&C1g|;OoqC-bUgDFdhpFl4a%wwujEav_7=f9JP9;aPQ^hHlkNc&T=uWwO)K`uAoO1c1"
    "%NJd~=<+3(PkIih=#<NsXpWcvi~e8r|EB+U{okcZE>&`=l1r7`s>!XI+^YG}{>&6l*USsf3)~xp=a$aN(ZqHaUUpvQp7+m6k%lu$"
    "c@NFr1G4vk>}|>3L$mkL>^(HQhO=w9c)u*(FN;fCT(8CLUfk}*?Oy!3Dc$;DajA-HxVThh+LK#Y!&#{9)G@R^#;d`p=%_z8)t{T{"
    "&vkXJRhO^&b6x$puCBG}@>SPb^&U{Y2h?L0qcv{)UZM7%yogJ^{0(!EKrl~``j=kYTvLj<g0;V|3DF5Eo~dZ2F4#+)=2%lqe!mam"
    "ypFw!4Z$XHj$=o$DHzE;{P%|a-WKc-$LkzcCy(ywr5-<R39S@!85<@`cUd}f1^e_@y8j+yqPjtHey*TT6*NT7v54bxek$i!g0b#h"
    "FQ4jVNE>L)oIY>Er)`i`bNaXqpSR%yChKNuk>>7Rt}|CKYQyw4Ol^bgU#H1!a9w|@YuUq2v=&e9zAMFC!Ke+><(w*~tj80rlhd-7"
    "he|P5u&kW!SZ6L_Sv+#ztp~+i!GdzSW1YEz@gV}=_yWaT!5aOmRt^+%1tU*33@<md+!T!8Lv)v=t1L?}@-AYs*R!CQ%NWgX$X&f0"
    "`&QiNGrvJkjwQw99eU=sx5?X{wC(c#Hq%%KPIrubFKIiCc{$xpKW%%Fw$nJ5i?_XK+vSaHF1#P-ZBN>Ec~_cgjDvKK%gM4x+Y9f>"
    "dE2wLUEY`G#%u3vO9N2M6^vwYXId%d()g6Sjf=Twr;1b6sixytmSZN>wOk>EoHWUN)Fe5U3}cThFYaNFmwSN88==f^gpy;)FsYM|"
    "TS)Hi<vMc(OPafTImW~Se2gOa)*>k83f9z?)vd~ySZC3?OxCedCn)9$_R&8-D*}qSf=$&%cfBwsR$WWA(OoZ$iB%U_H8d~R6cej1"
    "vQu&_8O9@0-ckE__THYED_GLLlf4%)CVJUfb9XPtZx>_~*hO=9FUMFBjP<#_+*VBVxmll%CBsCY{I+I$o!jaZeQwg{c71Nur@XPr"
    "oAeo%VW5~R80j-RmJJhqZW|%8j}Y8;(dRz;++=@(7!!S-M{{>C*O@C=(A?e2F(&=<M9uwqxsSPmCC&YLImW~e{2nN}ZKK*&-UQ`C"
    "cF2xp!^95!E+~Fp?o+G_Mx$JIEF1RH6I@>NhRbVSTX~aH*{R}G^%Bi_-Kp0p_S&LQpO=`9E~mCr<`<XoI2D{SZ@rA<RCcO3<?@Z@"
    "l*>0<zA+sAoage5Wzvr=t7xWNKAQIfi0~JJ5WLSVMEVo2ynMWOC<HAfiV(c(A_Twq7lKw3QuX)#1+m9Bj3A-#6Z}p<2o^~QmV*fz"
    "bff$Pjj&OEV!FYmD`YnONcA;j^)+PmHDvWQWc4*<4aKSIRC9{_1Q6s_1|i7j;Vxcj=~t=q)*^fQpqMLIQciX(GgmO8ayJYVa|J7!"
    "yLdU~6u~Ox9$s!}Io5XNrA!loG%1SUh0H6&))wTWEudLnmLHX-cv&M<TFuC^fm@&rFRmb8%v4{@RA0>0(w%yp8cuyqO)tBgx1F*@"
    "Y;7c*G<QCKbrowaDCP=As-M9yP|RhFX2wb$o|TKhmb7!Zg_k#Ac>|U=V0i<UH(*Vt>=~)sd)xNjw!OD)dxq<FWp4l7?Z3N+=ks6N"
    "{%hM-q>XxXVr#c#Kihnv-%@m5aw<DooL8M{j&`SBr-tYIoHw0Xj&A3fT3UAba&XFqww7JK?DA!oFIVR^=ed0Ob)L)TN^7pPwq3rx"
    "opSk(%XeJ9<MJJs@0jYl4-MUih90_8uT!5>)2ZducFJVw@o_3R6`e{>6{lR5=(0qYAP%QomgurXm&IQ_bbs~Gi&?t+WY=HM_j<nf"
    "=JT3;vg<zCb)W3|bg8CGHNEWgveU~>8xi_?oC;1wr;=0lkoD!d@&~^A1K<6D@BYAdf8e`6@ZBHyzFfZL^7$apeGuqA2y}n+yFdDU"
    "yHvY6>Qeb|(6?)RyHwuCyZ7<#14G~2Dc2hJ@g_vTjL^A<ze0GYIxgIC;f@P;T)5-H9T)C+cQ`KGap8`u?6}H~y%Bn;yS}midlPR8"
    "D8*dHXh?f$J);;X<_ebSUvexd##0wl+}@WaK5pgf@9N%So#plE?Jf2`@udmur8Uwk=fGZiEM8i{SZYwJdFrFo^b|`RJVn16qo+2d"
    "K2IG=9ZAtIe=H|)=|OlW)%|U53n=CaHo;lVFzUX<<?@r;M|r4wzJq@Mli#2&`i|%+`o(c1MJ3b%|NA#+Y8Wa08zR@BsbJ7bXNX)w"
    "^*1u=AEb#vn$WzYi9wpM)JLi5sr@&owOY@o^-S2|OK9&$gZM}O{8xD8sT6Ys`@l)tFq&3~E7;WB&C50Ba@{KHN4EIL7N5xTku5&5"
    "g{H{A|6WRoE|p>~V>B#%v;O<U21+qkFp`NhZ&*`IWFq@WZqx~ixh#{mduqF9<{*;#Z%VtBVlL;=zB<Xp>RE_NU5p9sC6m0M`JI1r"
    "u|ud7a|LVkuNnr5xq@}&RL3fF1smYZXc+lZ6A>rWYNEW(p>=*NleTP;LxBIMXn)aEyr^AEtfv%n1^eh<bF3*Q(HLY|$t{*uin(03"
    "YG#qF@*6Zjul4?;H0K4yT*0Ptj$?<pf-R=J+|+VQu#Mcy%PlUq>328pfjmj5*Qp^g?cC)YJ5#Sy!>P}x4=1gedY#fbW|tGlOubGG"
    "r#_{Q?_nL^!#b%r)tq{DFZhsqb#nZ7<W2b@J)S%*MI+%U!BdU?RZmU&_gSjGRPLb^FS$+&a$1?Gs3(9=OU(aA9O2VSP?klf73E9h"
    "MXP`3BWXIybV?;jahV}?G4(k$omxiq$9}U1)Q$4p+@$00@=nj9-{bG^j=#S<wB|prYla+_^SWke<$Z>0hE~;QxMpa@e1>a=Y<XVS"
    "%*1Rd@fH$bQU1{%?(9wrM0u$fH5nR-ctuJgh7#Q-^N@Uf6p}BH0=9dEYyoW~q9~D!Lw=DGUP<TI0pbCKSKRvu(tHad&7BLwy;~x?"
    "bL)dzM=K7uddXX;^-I2&9GCnqIWKwqx4y@@U$|tvWV&R&WVtoeOSVhi=6vrZ$0e_1-<9lJH^UWjK9{^g&MV|hH$%SURo}eon^%4F"
    "s&8KP%`4=*Le49s`_Dw$TpvC@0Q)`E2ftM02$#|VAxGyw?I%a`9343Z|9O9Myq;qq$K*fXPma%XOyuB$WY7A^u{?*Imij{EKjG$3"
    "S|D!LM;%-a&3%c_Y^HIuDlHIlEdDcpa!k)5$F@FNo)W!(a%{_yp*mW&665^jIG!UQN8&&6=1^K75jpEK`T2$^k+y&)a$WAeq(9|f"
    "doCF+887J%!Z&mn`NpRNEiq)M`HqeVA9?*kOdEyf@?V%MTryq~2L%HA04g`T5l*&C_DjB(9Ji|PlJjO*m)w{12W{>v;*Kf|t*w+W"
    "@pdty8qtjCM%<tBRS%K<lK#N0`CKww(v}fKrpwKjESId8Y?thp{Q0$U>-{cwUeb2|iQIBbOi0(#VnfP75+bj>*N|&ndDoS9U3u4)"
    "cU^hcm3LivuT|Hz>RMOcJNGPKFNfs|=CH0+*S_-ZEAPJY?kn%U^6o3|zVhxX@4oWxEAPJY?kn%U^6o3|zVe<c@451xEAP4T-p;ko"
    "m6sRQ2^KodrsKuE&q#l27B8%Wa<9C{4ucT6Zr&^JIp&FMJ!Be-g>e>P0>d#=!K!08`OF7Rqa9$2IK00RGrIYxsbSSIoPOr5B#yjE"
    "S}rDG0xOa|CM^f70IQNc1uaKQe`W$}l3lRs7*0-eoVuN4n0j1zW5(Lg`?n3-j^Xq)A3V+0zHDv4`Ds3SYFKp)C#ZSLK3n^;wE-un"
    "`S__})iIo))=*NkFIyXMf?9(~(LTp;ay>lw8IzMkb9T^^>j6Jwasq?>I1H6p%gQZb0!zrgtejx5UyyKB-FjC_*gy-1tU8(ug$+a1"
    "62Z#`VFPViB6wLrVMhy1U3QpLWP%+nICa@^PQhSD4NpyWzd{muU`Gv5O%@9e40e=*es&Z>DPaTU$Le+TH59hw1FqHjPSyT_Sk=u("
    "Tn(#^!Il=Tn(ffLgcHD)7O<M_*t=jFg%EL$w%LK&CQM)nCuy4<sTB;i)UZ|b)vo;!ajRPcSJ77;gB|%WuJ2W2tD2d>8h)nR?+FGQ"
    "@`2oLeYI<UM9k~vBe{lE$6!Madu7(Pa$A_dK4jlkPB7R|Ltm5KeIfQm?CaLx*JSq;0E7Lgj%g>3KnN4q`P+tV$6!AWfwj|5AcP4l"
    "AU-2lpoU<uUy6uvO&08$gb6Gm$~9TIt6;Dn2iATzW_&s>AhLFIXsuz@G1!lTYp4C*v^rrw4zD$=ItKgki;kVD$ABacY=I5=^~X-_"
    ";?_?Qh08BR_~()Z=t3sgk(~8vSal3`OcP=*lXnRd*n*hL<P{8dO!OQsv&S->!;XobL&K_Lup>GBlD%2ECQM)f*_)LU40g;>vO}*+"
    "b(dksoFqH+>KN>pGvZY&&=+;Wj=3OW#X^07!H&5iF4*o~L7lK;Zio!FdoqB*jv0Y6$%2tZ*N6q?*HqQ8>KN>o2YzPR?=4{h`|vZ%"
    "eorviFY5vMU<c%-PS`K&5&2+8<OPHM@<#S<<+?C|9c1rTPB7T7JRHDmvryLXu#H&bT{yscIl2sm4NKG#!OI3=15H{Ycv(SVM-Eng"
    "EIjft40hyjWy6|dup<X7KNceSsErY^yg6jqu;v)-XhF*s=nM>Yw6J9hbp{4Ia^SN0S;hP;L@sX*T{f&a20NB1`TY4V79fTQ=3SQL"
    "y|@L5A&z--AhY>t#r!lxGH(uLHmo@Yds;BF1wcz%5Y4<ToY_L4fx(s>(44HDN!x;m=FK6^hBe1DLN9Y5w^kY~Xmum5c~?Ha@;Uk$"
    "3R_k_)M5rxO4vX-a5^{|423;w7x@g{?mHtode>KEytua)cC84;c`Se%80=aRj`LUuH!#?h1EtL`E#{XZQhIZ!v|-IL*pq{$%`YwH"
    "mm*qvbGWo&%`w=M1E$TtEaqP#VtRAPv|-IL*wcchEeJejVFJ^zX$u1f275LHP$jz)O6Gb*PVa^gs$}=~0D~<Xf~X*;`ISv$H4#Py"
    "IUR!?Tjzjw8zrg+^=-sZ@Ah&~yQ8n6upz(bmQctp=+Kc3vDBMie%H^@&rsO0ksYfA)>nkjZ$wn@Ms_r;IR-nnE!m@$6B{F{dbcCl"
    "qm=^&JN5^0=#K@YKf(kS5Q+X+NV;IKV~@xltXvQ#u!QWv$_WNLb`5~<R;~*Zn1;Z2D<>H2*ekL(E7ybxtRZ`|a)N2pZI|rOOVhS@"
    "Sh2s79eQyLHth5qn$KO#=kBmzr{~bH<{0ePC$e`dCvAZJ`a<?@<phKM`bJz=vj8ut6ZY$RPgJuIFTr5H_d#@hv@rW9Oke@=_0a<D"
    "1%v(GDA}Qxp>2O*zc)#C=*2PE@6D1u+4TW3CcLoUTO@n33j~0{es2}m9zIDo4EB2)hO=(tS{Ej;4wDYE?GPrg7wQ<M7r|h^m#=BC"
    "7(Atfjks!kV`4V~N(*t*z#jU>#BOf`2CWUfWb3sM##flY^qQ^Lf*1vZ)<*uDwrHNVW**SmD1Y0q?HIH+DzZOT?hz)ihU|}(6AW4#"
    "9ob(iC$d0m<3;w@$_b|N<^$Q2m6Nuk*N+d`la&)p^(jH;kM=bq1pvN8hZhfqqxTQlHM8;baV?<#kHcGMj@nxV-14yH;HtmPcuW(x"
    ">0$F}*2mvwJoYx@gFX3(>to7LO4vY?mUz9aps*<)hJ8#SN(mci(Gtna3JSaOu~{goUVT*ofHzZ8z4{Uy_WkrtO0qX8Qa9}T>6?^f"
    "Z&Cz<eLubE>$Na(X^-A0pjUmp7AP(l?E6h*x8FlsVB2pYyZs(8*!81TxW#{HI21F1(JI`q?HFvz#~_CF`=K_Qu;>iP{#ZG|U{5~S"
    "Fs$DXZNr2$XF~SZ$_WNr&W!BI$|Yd}E6AR#oM5oy6q|JK*PmVwMgZ_8y1)2qIP5qzoc^_NdXWisoElL7T0p&Eu;WBXeYA_m#KseL"
    "oCvCqcJ&xAy&D2y_0ewP1O_`!1lC8pH4zx>I5pJywNPh~1$LYo?EG4=vtY2}dj3|nRby5g<8G9_!rw9MI0ieei0qG*dxQxrA^T(H"
    "1cMz{M)udry}|@mko~oCg29ffB73rONtnPIvL`Di80@#Y=+Es7QUKthi*@m3IPACvUvOh1+pskyZcf=tF1c|u7z$gisU;pSE1J-o"
    "K9-hvysV(G=h|B0^|GQ3SacmN@p@T7VblF+iR5LIuz?0Gk-V&+uq$usaf#?<rI+b_E4<S;f}=L~>YXbaD}ZQMP62~$H&y`AE}a4f"
    "+it7?q%p<DHNCB6V+9~sa}2iSt;BI$`}Uqt?`+vG?`IqOndS7}mOZq@<7FRV1O2qb<7EYfUHJl+aa{ZMMClDKe1*&Bmix?dc8AN>"
    "63NSoCSccnv_$f<g2JxnL5b*PMT@x0WuJf&(aQpbU5{Q*@R;}d2osoIQ1F<SCKzmbvSf!%ZLGo_G5ZwB4x2g#n;yLq>$Tr|g$YbA"
    "#d_`c1cObFUW;YFC+)}mGW)1EX}<>yH_VXC5_%hw1>uGyY@k7T+0iU)piy#~xs?<ExYQIb9t=;wvlR-rd=LP5u|naN7aTY0u-_ns"
    "a`f_9WU9cM7BV~--hg++Wuxt{w;i|gJg@Syqav^BZAi}Bwr*|1{XBe`8s)wCYdCJ{!DT}Iw#_cr!EW4nmK6%Oyx_R8htHx&A!}Q="
    "w&C8M=V&3rU&C>?QFstmt#&WkcI?d^4$u%@b~FncXq24ZwqSP04&6ab*Y3gWj$OKgx~|=W*&X|Ihxh4FDBSXb!|p+Y=GAU4JM6~s"
    "O|Q%Ty6mu97?ShKW_H7_+u^I!DDTD1ZrFJ{VOpVZ%ZqHVTUb^o-136MZt+3Ly6U~D?AS*;F(@xPnuQHCN=}z8n%=RScB0gD^&U;{"
    "*ikz%TcL2v2LXT=D->>d!J&6P7bu0aPeps)u)B76S4;{SZqFNb*iP)Y#z5`nZHL{WUU#5&^R~loaY)YFHnSUc+D`l=@5Rk-*ljy;"
    "TA^^uOWR;KenW;r;g%O%?Y6a$wauP4?7W?Lw2<NUykYn4qzBgusNG*}JNDmB3d+llW?=)3lGEFk%<kBQJ4tG~c28z^?8Kdvtx&k-"
    "g8;yb6$-b!;IKPit0IN8ZOQD8T{%9yi$aE*-LW%wQpdFrYIkot?4DlbWk*F`*gXx&dD~`o$Ijg0V|0}F;%0a3&Yd)^P`Kr#ZLm8Z"
    "vO}S8%L@*>r>%voZDx1u)SYy+kl|)`?A9H=Du%CxP`e*(d)9m8g7UJXS=d0M<n*>>vpaU}_<%I$y|~#OJ9j5%D->>dxvCC!&&3Lb"
    "TV8P3J$GCmqIPrHVYmD$FFPu~2fOhx@{_OKve^wga)%F>pM33>&2HG0J9%26aLbEquv=bMDBSXb!)_cJI(?3qHb-EW?Qp#4^f_YM"
    "9D!XnK3vW@UAAI+$3ELBQq$FYF}-7_?UZbV!YwZs0qPxr#R`R6UU2BWR4t@^s@U^}T{k}NjzWgp^M;+bQ(j!Pg4PXh9V}Bmp|A9&"
    "dF-Pd-X}ZdYPOhWi)!{L(|+B0Jodv*eQ=?PYTll9?1-Hjl$RaN!Uh^8r^{AN^Vk<VRcgALucmqIjh&jUP`KrT0KkhC3b(xA&^+&t"
    "Ng-`pHO*s(?C=hm6f)d2k3F(eJ1)*a+lRLuPfUH4mmL*(VV622=WUxkG1wzJ^^?38H@jh<?9^$6!Ywat!xK}N6$-b!;IM1mTFBaF"
    "BOUh4PCZ)4aI-u1%}&#mgovk<uz}juK7k`IaHG%Tcl$_2n7Adq=O=I|2Cnyc{GuPp2wS$Im;MBf&A^>KkKf)S8DX^6^ah~7VH>!l"
    "=ke=$BqQw8UcI^}a6|`g?0Nj|9?1w(v`_Ex2^{8u>w6x*$VW12HA^q`2@?B(6-v2_l_CJ}U@Mez7b}9}(dgp5$BRe9p|>temvr%D"
    "I3A5Ii<f-yY&g`}WwBK*UJTdkOJ%WDFJ29Ymb)yr+QpmUcr<#qRZ6)F7QvzX{@N;~+y#r^cs#l+xW>hY;jl@U1=n}+&u}~*T^3yP"
    ";?r=Ls>_0FU3?i1Lw8wl?Tc^2)xNUeIu}2NqwBqodCcWH&qV;>!93=2ooB&e|5u#JYyW8W$JQ3d1hJ!kakD?Rx6Uih^tFF9`(umi"
    "yyE;{`$w}swz<wL&i}Q4H2Y(#>%8LpU;9V1KeoHh+s$h(*MSyXFTs7yYcAJ;7993}WdU&QAI<(R?ElIF;MzZ${jo82UReNK`$x0?"
    "3;Vya0J!##X8#xVe`Nu1?H|qlFYN!y0^r&|n*Cqce>^sylsmN)0e}aaPs*KI1c&{H47Jz()$ET=x-(>=x%RJSe{9s9Aydt@e>MAK"
    "v+fL;8n6AU*&iErXUNoe?O)CQ*tFwFGoA)7ZuZB<-5K5HlyavR!D0XL+MH7E^dh)kg)GzKwSP7HV-xQTnI5nGtJxnLc^v!3Q{lzU"
    "{yHlSnI5nGtJz;CqaoAdwSP7H>l`#>dc5|pW`CV}KARq^PmfjDK=no2<1gCe<rp^e4sYh2cKc4VzJu+&^CgrKSSeux%{=uQI;`E;"
    "&O2Y#64A>>VFPVK`!9cHb!^w2PhX*-Rj;=SHvRM!+T*X#&?;E;8_IheeS{74)5{WxoPg1Q*P92!eS94tYMeptV3ei|b6>E5cBbg?"
    "_Wx%6ADd`rCb$@?L+icRMmv*rxLt>4du*g}>?BG=FDt(c@p-H4%&Ws`I>c7lnRW-{<99$l!Up>4eUL;By$15}3n3*V6vo#S>RidU"
    "629J+*V_VxP44OL1sN#-@NLX+ak)htJ$)W!sv`(e09-S!uR64+>+$o0&9SreRmbD6I;2lvd+e;Jw@W^L&*UR)ph@qXBvM^IRk``1"
    "*x5R(p)gQT!Un4EBec`HfY9>N_Ysf3kAQ$s?Xt@*A4f$%*kFBn2`7=P<+EMO$8L7VM%CesDlo&v<wkaBnYXHhsaggp0IqD;1uhyf"
    "^*bR4n^kA)0{8I+t~3IhRcA-N|MKyhFdtz9O?oRPk<{&{zagLYh8%lSXBXvVN99K_VeE<@RvQ!*ANx~hH~g@opP{hO?s{2h^=m_="
    "aj?+V_3h*9TQm+9+CzDdqtZB-Wq*3zDUtM)3>Sa6_;^b8!hNofUF<5A=ymy9FL@>M{OQW}$N+OEm}Ublc8ktQSRde_oHo5-zvvv+"
    "v=1=T1{nRSz^Pgydf6y!piOB1<zoX3_J+>U_c+>T?Qz$y51dyohb408y|0ho04o`xy7TF6utZM4Ivjdiw3_wz;f8*`sQb|y{`soz"
    "NA4epj|XfL87_&yNFtIE`GVz=^^)z9-3q-%3?sgqYdX2_FKgT-5!HxW@wSjqBHzok%6ZQd#Ju^|CHEzdlgI9ojv-doAjt8TaS46="
    "@L|>%__Ct#(uAM*5Sftz0O#Ak`NI{4N5fGQ--s99eDSRKz@_#alNr{ne_8!98^j=in(LNdR(@)EzSV!--(U9o6IbKQt@6AW1+Jt3"
    "z$IR=U%VTREAJoC>UZ(aa9m<9ca+Clf3*4|>X-Y<c`;*nF&r24^Tl2<O~*kB0G#X3xBhJPXVfoubmv=tw)!)!`Iq~;^KD<Y_GPq>"
    "UzaUKK?oBV2kP=dK+A#@062HEyl&lI9@qF+zGc|zwsuuq<X_JpU-AiT8wQ&-`Ql8zzpFNn4RUc9cdWO~)!N*kGrlJ~Ht!Qk3ILp="
    "u-nyXGo8xOX8KR)dhu#FK9ImSGDJQzX?QanI_)gKoYPc%DBdA|m#^mBKGm#Gb;!^6=*E8K?<RkT{CvA^>{tG7@^{GJg}(B4lfOg$"
    "E*Du``Mb&A^)nCL=g0m1VZT4n=jFc3ar@M;J~d!>xdoF)Wy4>?VSBzCGmhK-VeKEVzkG41-Djd%-`UU~zB+XKU9*0-p+63Qj_>Wa"
    "ul3uFek+%X-7zcLm=)zf4E@J}<ln_V$MLZXj((2c)&FPu-}vN(jKtsVzn}Hr4gJaR{N4WhS^t&!J@Qu!Xy)sn2h(Dg!IQ^WXg7`G"
    "(<7_n^vG%=eO_7Z$W;aL28zcUC?0R1c)Wq)@dk>=8z>%cpm@B2;_(KG#~UafZ=iU*f#UH7ipLu$9&ey{yn*8J28ze^)0}hVJy+gy"
    "<vmy4bLBl(-gD(WSKf2wJy+gy<vmy4bLBnfe*D8i&58Up7M;jx-zRvYT@jle`Qk(ddHyg@kOw*W54*xIpRaLRAmrftM<uGtaxBjw"
    "7q>sW>Ga?fq2@T2LpGl1zsP^W&7rhF$iZKQkT@dCkvs<^EtUV2pB%+=ROH~hUL}^max~A;k%N0R&KGHp*K-WyV11MyeH7P6fj$cB"
    "qx|TjxIPN>!E@VFe)LgX9~JtjtdIJmkLvoU&_^x&C;#Ngo}(Z~<3IH$NA(;HIfU*%IlAYN&nY~-dGXXANvliRASrKPD0lqi7y=<j"
    ";y>}$p|n8Ak)1n!a!4JpE$?JJ?Z>vwZQEd5-px?%_{kx4ptVhM|FpJwYn!%qICuQy5H76G+Zs>%v3_&wH&~yyHk3Pla!4KWiG%0m"
    "*5)6(WVg$U$B$?{s8kI7^5s7D{`9HW`_zj*#b1qh#*bvfCBvs99{xVWGk)qAUI#uB@$kF2XZ%=uxV7;)i09*e`Tg|E&->+ve#vju"
    "p6};5{roxoU`u|p_Iy9K{M?owY{_rWp6};5{roxopbvgW_Iy9j>F3Ys2TSqGvFH2I$LIR^pbvgQ_IyA3_*@?!^f6f<-;X{%*T;lD"
    "ChKGV=wrG*CiF4+Ih{Yx>GbDx;yIn%bLUTgnBE^IdhQhZr{_-Zxf4B?-z`1!N7Ct%E=bDnmy|nxatwixgP+s&^PDb!PVtcqUUnLH"
    "{N#{2U|W9u^sFD-F1PK1ZTS_Ha>q{&sRONDlKZE%%Uip&wZpmNCx>uh{l(T_Kh|Gv{RQi<<=pX;L+ZeD%C8=t@ne_ab~$M6;kN7_"
    "t#8-*L0kA011)NA4y6S`4xxW~(D5F0&{}@`@SGpJ9Jk9sYY+G2^V5@$_vFKu9ggbPPL0~~CCer2CEF$YCErVqOMaJ}mt0QzUBN_N"
    "8QhH`(%h)gpDJGA;OmS*%&dg_iR0eEOJuxcx@5j&xn#X$yJWxQd&zOh?~?P9>yrDD-oSnv*lz=0|Kb;s^ODQSf-Ahn`z745`cB-;"
    "H}180<KC4w?p=99?#hcww#)68+?RAo@AY<L9M%7~aqH@NpXaYnIoCvV_@i!=K}Wu)cz{lP)3fH`&!Wq4LNtE}9XCe4WZ9DB{U_1w"
    "@5SaK(fx;h`2!7FmapZtdcMC>I&O4)CV$RBe{22KAaDAJ-hZuDmHGTNY|fuIko;9noDm)Vdix-AAo=@2J%M!obj?HZj|Vb`@>iFf"
    "ZY8?@H4HvPH@+QxgYJJl%ZWIm<ziv2pX7fJ<PZEIkgj#|hs2x8M)H3T^chJ0Xuowx=7>5YSs!=M5FP%?D!Av8zf5p8@<-BtnVLWU"
    "^|zu<`O?6I%(3z<<!Eng)b@b(#{O5#j(nF(3(zwy8|u=wM7~?#z()LFK2zmc{Amv8pOy|K=&hTyb|_KxlOFzH0p#JkREA6>L`QC~"
    "-q}fAy>66EB>(e3Z>f+T9@L*m{#qbIYJ5vK<fp~y+q94Im78Bx{@^Q;A%Ei7-L7TlUwfP8S$}N}m0|z&q`FFnFQtaenf0&vGxeXb"
    "AWx2er7z{Dzj7>p{%f<M&P?(@4SLAbfADgOXzD**b)GvvJIW{d>wz9J$0Dn}GWGvyWhdz{K!=(75AMe$dQ*RRR37U8D}ttlSHnFp"
    "hp)?~u7N&N_=Bbkb<&vApRW8&c3jX^DMU}DN&XR(Ci&NgcF}^WC++8av3AwIP0OhM;YL`#RGa#t$}{itRTk;<Xg!<93h2L3|M|2("
    "&_by`0r}<52ptD#dDKcn{gw2ewBJ_Je?MpoEs*m0@Vk}9A8eQt-RQR-JTJBX)v0Z)97Wln^Ez0E`n#n6G@*08bD<Z=%y%p_?W>jg"
    "PtICDJ-=hXF0_2ApN=`SQ0my$CYnEQ(eYc2?_E<p(A?akj*~Pw*QEWEX6II_@>%|&`RVx$I_~jj-h=jGnxSj&kd3D3HdUWANB5}D"
    "NMrqLA84B|K36_JzX!j?cLn5(JU#Hoa-avk3jpy+L?{0Chvuj8^JrT*w*QT2d#`-eI&|J?{2w~Dbb5Xf_f0hQpRHpH$KuBqcI?!D"
    ">cn%`ssDUU^Dn;2US*^42X{jdefV20(A!J;$JdvM=6ls%{O-%+XGB{#_C2WWXld4RSDNM5=kz80FP-~d8h;+u;oJGveaOa(HhhbT"
    "Xc~VWtN-H*?6n^1KT-SYyNDi|hwtS0pdWIR+N1O7p!uuo_%OolSA+GhwjMnGsJ#a1KQ-uW@Lf{cPX@_9lhQnY>2o^xPN9u<4eCGj"
    "Xr1FegM<42(mqU!OnM$+_p$iPAu8ME?|Nuio_|%(<h1lBLq8vlKQZCA$b+HhMENxTHl5SShoOF^G(W#OF42;)z1kLXZfH)`dZ_=@"
    "PxI6B`)u_2Pd?10^^^RMj+3+~q;_dNr2nbD0l7xCypW%KBOjy4`)Wb^Bsog0>a#%0zMgeXoa{d|rAdAqj3b)#U-cQE)c<SLdK%eX"
    "``D!Mr>VU-`nMhQhspDAMq4<#cdL&yCx3fI%aZ;}QJVDMtJcHgzs{|+EPQReq6Hw06_9Q5myJ{&TK3VH2sszug%nZGqVazP)KAO0"
    "x;Au33%Gvtxn4B>n2l)JRzrqe7LPyL&)0XyZT_S|Rl6+i|55Ab{;%`bIy~Q@f0El@tIl_u@6yYVnH>Mx2V^GCzfK)9H$T7XGf0H!"
    "hQ0W*+|%$|oBbah>&X4@UHi;t|4rutS^&_Pu4Q@r*M34vfV%ZrASb!x0DaOTpoImUZ@xq4g>1A8=tcdI!}G5`?|f(PEYJyG+q+-X"
    "PfJc(Xepol&k5Zg_TRSFNzd;ve*bG<#P4!6<9s1AEg4&!$|wCl+P4pl|6kF17JqV1^RWMuptr;0zeJIo@$kpeAKZ~n{(r$u6hw3X"
    "fiE}6|8H|CKlA6n3TW}4H)!fV70>K=xc^8L3el{8d5ugo`wtSOK=j}*)My^k|F++v=Ql`<2+^ef0{I7j)V&wTOul`sm<vW=9|peY"
    "U>`n3%|kk@Q)$v6zT-hOM}!v5Pda?j4+no1{lyxA+#njS3ffCPe4C%<r#^5nhL6bW4)`sDe0B13I_N@UMN*o^1X`$rrvBF9(+={t"
    ">8BtM``d5S{In=rszdU(Y5jxWC4Za7K-h@yGQ`0<qRC#*R(@o?;kU@&F1jul<ZqXV@qduNT@uz`{NWH9S~Ne6SL%lk^0!N^kca&3"
    "($yA;{nep-@mICZ$+XHt{_688fAh!KG(XSR9eK##rZpY(#&`CW44sg_UG-TWd?#OhAt(9UG{nM2eCOVRZ!pN;uDCCh=*DxsmL*#U"
    "l_&FEYZ&VW`P(g99$qh4{k&dCnxAa_!cQ3FZ#P|s4)(WStjh-b+pqQw^0$eG4$0r9{-ZQUM{9e@-)=*7$al>R_-upy?N9r*_}lP3"
    "2Kn0!cikTTd`rU}hKE1i(hw+c_|q-4hJsGW-==Xxe|Pcsq_ph*p~+vx*IN&N2Y{N6-z9&$zc1QC{&xT1>kjg_`v+frkiXrhKAYrk"
    "_w_(0<ZpKzl_a{|K3{ph-kP7D_jX|4%Kcx*1oF4*1OH_3b?P}{!XA|y0Ow$kW1Vq%DbYN!eJH?}jakPc$2#k0DF$CA7P98yLBaTy"
    "9|rv-1W(Kutobts{s6FJU5b_+%tzxJznIWY+2$R9$gwW{LnHZ;t{0Oce*>Ys1vER>1J3JU$NJNUTpa7A{KPbVi!aeaKn&4^7c-EJ"
    "9P9clE!%hkhOWr5u0f5_-}``(V@(ep+Rl!(J#6e)t8+HUv94(<O%G~@!#CKm&IS3|u`b%t*|D|(mmO<;i7?2qCK^V4d1ABt?3ilj"
    "<4dA+fi%dmHm7HhV_k9W1<`!D<y3myhxz4+O(z&~to^}$d0{qG27a-UU^{lKv6FuWIo3WI48FXs;dciwEOoFOd^w$VN^-1Q#biIo"
    "u_jvUsdpk_$GWP_<XAU-SvCe=I+iuhU>f=#JkY@5801*D@u>{!KK$%h&!%;<V^=_vW9@?iIo9pyAVrR~Km6oa_oVhB$GRt-V92rV"
    "P4!QXb$?ao<XF?Bi?)+v?GHaW)_r_hcHGH~9P6%*2!Bw+2Z--3?D?HzA36Y$W9<V6IoAE_&<Q!#K5(#OeRQyZV-5M)u@3s&kz@VF"
    "2HC{1hV#vz+3>+-_B%;W9%$4q{Iww)bol#R{ZanB0}y`&>C?%Z9BX?)IpjY6u7;Fv)^&Zd<*Z&>P&*&h{dDNyk2pU%WRY*3A8kG#"
    "+AC2f6F#<ACcMYN2ltw}JBweBW~E<VT8LIZay!a;|CNuo3n{t(Fcf})hL{rxz=v$ettgxF$x&}gewvI(PWqF7;ALsWY3y3ht?X!0"
    "n)8vXf#gJz-%f^`q;YJ;o1~#^rJJPDY~`Eel}5Qq8k1MONg9e*zsXnIu1RX*8aFA6)tjVYdCi;T7Hv<Gw^8<OLS_f|Hi6&k?JG06"
    "8f9OZ$-^l73Q0~z+3hCzz3P>jTn$mYCD|-jW`4mZ&3}=cs>y@o(iUlQs~Cq(zy0HqXZzPB&-Twtp6%b4JbZDuljV~2lK!zNzVzG4"
    "_mbn1-zDcI*CqF@*FUuIg!^fO2gj)%{cw_h?}6y{L-!y0{h|Gv4-c;dte)}Q-(qj|(m4Fe)VR6R(XTU&`{@ay{R=41a-}g{e(3r`"
    "UwOBGhMDPk>7RD*vwvv+$j5VX{h`|recN&J`$LZ(`uoX0fB5T%zkleT-!0b;_mf*pryqX);rqv8!jrLQL{xj6I<kF46bGl#-}fK="
    "{f2xYz*E3A-;}@KfAW1l`6lvlFcbYPzxgZ$91?u5$wGYj77mgAjSr&34;}4;N+IxV79phYk7>C_@}_`mz9UHdPrmq*@1X9apX4Db"
    "8`Y9YG)-e+nv~?LC@-dJy!|?*p8=wZKjkI;3?cu-Cx6>N=5BnC!BW6A-@Hg^zxhf7j+*roeMD97?L@a9y8qDc4?TY9?}wh3zMnrL"
    "I{eV_hfY7V_rQ>|e)EVZ(^4+}VXTn9PyTXG%i2#o1zhvZALRK@z6ZGG+ds(qPrd~lGEA3iCbf!u44wXV%3a2hvYrC2`9Ask{wLr2"
    "lMj8HKb(%=DExL(sA}U_s9$wTzXBCn)Ne+GZl9$iYN&j?hsJ;TDS8uh;3?ozg7?c_rM6Mo`ZB+%18;aw=asioul??HNf+6$DV3dP"
    "y??z{mhS>FO0`=D-(03ta4I^LoYD_S)z81E&2;#o;}4yF==?*MAKIUUdPs_@Q~>o&4u@sEu0Z{f|I%}{0<KY@)RDjamq%-EL4>!J"
    "7k+q0dGYdac>wX!4^MxW?|N_^zDPvBB_EFjU4Ll(iWX7bsn;o<J1pn^DRnN*PqEYChmJqA&rL+nAA0@J`-i?Cz6$;Mp~DXyf9U%e"
    "rqJsT-G1o)L%%=t_^Ibd&T+pf74Do)^!%ZhjW{dt(@THfU(537LVw49cni6It^IA}{txf`<kKE7pPzg(!;pJ&zfl!)`k}r5?&r>Y"
    "`?)h8(eZ~)KlE?e@<Z1jy8qDc4?TY9?}wg0^!lOq4}C5jeq;_mGKU|T!;j42N9OP&bNG?@e*2Q>ANj+NoZ&~#@FQpVku&_r8Gq!A"
    "KXS$&+2W6E@kgHcBTxL1C;sR&{^+yc-wk&>BRc%h@rO=7bpD~s4}Im4@Cc*t*VA^qpHCzDH_w$PZ#z=X^!lOwxhDGNzu$akI{eV_"
    "hfY6q{-Mhc?LPB<fBHP1zPNP#q1zALf9Usz#@rZB=kKiHyEL2#oamZ}lt3sHB}mXG$ZIK1(Lx{B`f#Gy8+lGtK9cZhf|iUL14s#4"
    "Fyf3cCuq5d9UD#zdyUTt-pfP)871al%CA*TI)7@i8n(Uf=L9X>gS>a71n-oDY6*UG+O%$dvYsOE`Z$%S@=s+5{Pwh3K6!nrb@Su("
    "l&npn2dsqG^6}Y(VZZe9W|P%D7_r1>Z*Mt4z32@~8_2IY!ZC<HLn0Ssa^jG5mM!uoRZ<c7lvI=*XHM`jm!>L?yzgO+rAIQApjFel"
    "PG16ZqT2QdCz|b#aH8A$VNQ^Z(qk12PS}rrb{>TjeBdivZOe98II%flwH-berj6q_E2*i1`MpYN+ERY2auew{L0$hDQFWU5vo%e7"
    "AiqvYQ-6pzbCM~J*T>IS?Ps|~Th+*~RdBF}6Cdx+YV-J&iubz2d!Y76@Y|J~EkP~HRTKQ8B@eX&zh=otYvY4dC8(tQ#-$V$hu^mp"
    "lZ~F{Qo7oKU%lK!vlsH5;J5Zeo4_w!%4Zeud;4h;P<vW138rmtabhu|w&PbV)yzff<${;olqkL}$_Z*u->MKkSk<N_s6Fji8EQ{|"
    ")T(^8s&y5VKP1$X%0??NO6ZUBr-HgYD1|=&o~<+T*MR!5LLVng9zG*!4Jy>2H>mOXOFplSQhdznt(vIf#SJxA6+dokDgGYMyHyB2"
    "Y&C)kUir%qQGb?P%<?X)q4M^I%D{0b)fB`xfz@NRk%{mjVovaxlVsVx-^Aqj+-do!N#9hv^2cmG|5ZOZMhX60&381Lc&1;_e7s5Y"
    "9eoIBiAf776_vM%j`cv^Cz_@%4nS#L?ZP`n(?)pSD#9KoC#Xep8bU3aHd3+^%pW_|6u;!l_CpeCyiEpvN$K_ROV_IU=1rs3RCl~<"
    "w6+Sw+eT}vsGWxH9<_PAakP%gz&l6ybRQ@94W`X)o!?(peT>LgPTjhO#AJr9qLRCux{JW?lRs@Ne+FgS<JK1^v_Wz>%LX9!VMcnj"
    "a{iXdKHAn-B95)^zwtk*^he{oCD=-4n78~UD#z?=4|sX1kDoU8rNOR-rDD*6v>a>VJ2;_Ae&r$rZ3my%!dWIxP@`}c2q&mfxHp3n"
    "{M!Af_6DC>w4O4;UwUm;9+7WpQRVT+L$Dpri7dg%mMR2UD@NsAJ#EC0Ek3KE+kPJ>-d}`w`OKRbpKbqfVp8JMb`L&5Z8P-XE%~9n"
    "X7HZ;(lVcK%5x&vscTN~F%TQQKR(B3L&KLTQB+qSpG5vtBVXmCBl@EswI>y;fZsXeo8p|J1|{pB-{3QnhERi&O)a#>s>ymMf0!cK"
    "BgV(w<7aaipX$oiO=uxi)6~g(20mx0#^ZRN5w+oyzo=>t#iSPHW=P?)geu&ujHtOdm}gX#l#h4e2m>ehe5oVi)<0?@KH^oZ&&|o_"
    "?6rCPiH2(a!{i%%f+da}gP??5En@>INBRuY!r~2ad)&yOri8Y8@s{kPx?g-)?N#B(rzW>kTesR@PD_7ub=%(M#B2MzoFEIeXySal"
    "+pD@-lM~uF`Eqo!(R*=&taa<~`8U-FAN*=vCFPS}y=WWc=$9kB!pT)d-Eta4e|GbyP=o4zlZoD-D&Z?uJ~Q5?7QNZ(<_~ZT6>d|D"
    "UYi6rwP@J<C~KYS`4*pRS2gerDAVQ{z60emok&DTAF4ZkVf2|#e)!rMdyo%*I@EktJ`eW2+6X=nhP`r5$i}(;sss`bn`t<fIIPDo"
    "Uf2xN>!C*7pW=1z{M71)>@+|7E&f2Kjdh2HhH38q;ZJa?^ThEXb?G!M0U}GE1C9{U&HN}KB6aD5Brzfj7Zym6NL^~pSKcq+$XJv("
    "5vn_Dg3kl!oW_wNbyv$qGtx>)6Q3Owh!QMP_cVF9;~_L9O1wy2#{}ZfnOJr5-r*EW@yhyiOYy1UsZFN^Qp0v`l(-Q+iV!7mgc2$Q"
    "Es*Hxu`>Kw$UHRB*-2lTcsZf6^2sxM{y2PuR#;J06!@G&w#4GoG3p~r3`x*On1e`SPU;GC7)gsd?{gf99*Kw&NYbJXz#K_JOQ*;3"
    "QJeH)2ni->@wGx^r`)^>>U_ED!^IILE$P(5Atfz!6M_u2)tQx`k~FLaTFCCtes=vP_*`*TwM0HxS+oLLB<Z1zD4``STQB0+lC16q"
    "2bZK{wxC5)D^UgImmqm2wG3~z6zj-|TQqgh<oDwmYY-*KguEerB00>Y)nE`AD&tndD3K<VvUboqiL{*Ur)iKl#~O0}@?$!ug_0f{"
    "i4t%^h17-RkP}X+Q2eT|1f2`y#YYMD5M=(So^?jvA89%aO6bW=bUT(3CHN$JZ|3(OwmRYPll<s{n&VIMW4)QT7WD*dln|8Gv;FF^"
    "n45?ols+vHs0N+tI1DA08nr$-7*{O8O{(g8aV!d@bjFrw6r9G42uFE!*~;-KIoL442jp<LE=oiSC9JxS6PArERo-UuaifL~(;S!b"
    "o1#_?UC3}~N{;&ahGSD=`RsAy=#<aK3I1g1r|%OuK82hRt&U&H)A~RKtb9a&S$#C=#$ib301oXTl~4Ja{v=H0v24`;3IejCM5?r9"
    "Ljx_Da#HV^V^!L+VUa)hxvdqAqlIj6p(RsJHvID2{OThJ@5<F^k0q^{aw^(DjwmJf&QfyhT9wYb`Zd`zMysZFY(Sw^Q#;4<4LiaV"
    "C3q#)ybK~!)e^N;9KiDEDvTpo2pT5g;n*vMcncw=qUP@0uBFv?J}#y1FbA^qpl_Hsk|k%ILphYC2a}xFP2;l)xKYhI2yZgf<`~bs"
    ">9q=nq_msS(#h8|9M#hG+9wTbdF{70Nl{G-YE)E@k0V=pv}cr7PK4-#$lrO4x)6J1-Sk-*jxKVfaKg$|jyuw>!|SH{C6$yzTo95J"
    "5#y5ViRa4+l65g!HuYq47A>24GBeS#sVDy-K4`8>bdGe<lcy1(E=k=)iFL7eRvhfolZ_vP549~z&>&HL3?JP0Y_ZHCFNB$)Y2lPh"
    "G>D@%bz#6^FO;y~r6v_~Zg|_LT`8zdMPHn9>`SaCniyoIqKh34f61k4<s7tIkLjP*PO&}qjML(YGO9>?R<GJT%!l==O>}%(ud4IK"
    "aWK7_BgN<S>aYa03DG7|LScG)v=8x-y}Ip3KRf#uB^stTd#L%;UUPBCOwERpk6WZmU5<$9O<y~3NKEh6izm0od@5Qx^={85EuAQ#"
    "DyF4VY~CPRJN52$b7Y3DIyp2ZSMxDw?bN#s5PaQdR@axKV`A&W3ef=3UVZVz5i<1f7(_;@HtbD_(Npng@uX)IqeRK*!Ne$GGPKlF"
    "8F)9MO&ehrpM16fpH@#a!Kog2^|Z|8;9wc|iD~r|+p+11mQV5N_Sn<<sW0<fY5hcNDD42WexkLJ$;z+!T}QNj>U&uY$Bs@$37m<&"
    "SXbka`ChDvw1Rr=%>zfzkOQouZ$4!iEJ22%?x8<LD=30gK3YMMvuHonDPbn$Aey)g8GKMvo3S|z&bkM!pvb*Z#qxF$t<P2Gw1T2("
    "+<u6<-fOc2t)N~UMvM|o6R&1z1(jbLzc`?#>JpP9YRa+^o>oval^Ifbufe7}UP6&;tU}NdDi2!{&<ZM#W|i{+(yi9u1r+&gR*0OV"
    ";Xkz)GFORKP<qrfN`Q?gIKqZzp;r^sC~9KWROFzLsEPEKKlSi9%!Y<}D@2WYbq3-<8ybDBOyel@tqE$<H!VSZkH(xwQ^O9tMhUl}"
    "2i6d>)6}<ze9SISuYn$?xecKfEq$ap7KdCH%SS7yJoRk`hvr1Wi>By-8u77=nNvEwap2Co^%>{LoxIdB<j|dWYd_-Ho!8zUa`4W3"
    "yz;?`qX}x$3048M=_IR~%rxrr{C}}<LYx"
)

_S_BASE = 0xAC00
_L_BASE = 0x1100
_V_BASE = 0x1161
_T_BASE = 0x11A7
_L_COUNT = 19
_V_COUNT = 21
_T_COUNT = 28
_N_COUNT = _V_COUNT * _T_COUNT
_S_COUNT = _L_COUNT * _N_COUNT


@lru_cache(maxsize=1)
def _normalization_tables() -> tuple[
    dict[int, int],
    dict[int, tuple[int, ...]],
    dict[tuple[int, int], int],
]:
    rows = zlib.decompress(
        base64.b85decode(_COMPRESSED_NORMALIZATION_ROWS)
    ).decode("ascii")
    combining: dict[int, int] = {}
    decomposition: dict[int, tuple[int, ...]] = {}
    composition: dict[tuple[int, int], int] = {}
    for row in rows.splitlines():
        kind, source, target = row.split(";", 2)
        if kind == "C":
            combining[int(source, 16)] = int(target)
        elif kind == "D":
            decomposition[int(source, 16)] = tuple(
                int(value, 16) for value in target.split(",")
            )
        else:
            first, second = source.split(",", 1)
            composition[(int(first, 16), int(second, 16))] = int(target, 16)
    return combining, decomposition, composition


def _decompose(
    codepoint: int,
    table: dict[int, tuple[int, ...]],
    result: list[int],
) -> None:
    if _S_BASE <= codepoint < _S_BASE + _S_COUNT:
        offset = codepoint - _S_BASE
        result.append(_L_BASE + offset // _N_COUNT)
        result.append(_V_BASE + (offset % _N_COUNT) // _T_COUNT)
        trailing = offset % _T_COUNT
        if trailing:
            result.append(_T_BASE + trailing)
        return
    mapped = table.get(codepoint)
    if mapped is None:
        result.append(codepoint)
        return
    for target in mapped:
        _decompose(target, table, result)


def _hangul_composition(first: int, second: int) -> int | None:
    leading = first - _L_BASE
    if 0 <= leading < _L_COUNT:
        vowel = second - _V_BASE
        if 0 <= vowel < _V_COUNT:
            return _S_BASE + (leading * _V_COUNT + vowel) * _T_COUNT
    syllable = first - _S_BASE
    trailing = second - _T_BASE
    if (
        0 <= syllable < _S_COUNT
        and syllable % _T_COUNT == 0
        and 0 < trailing < _T_COUNT
    ):
        return first + trailing
    return None


def pinned_unicode_15_nfc(value: str) -> str:
    """Return NFC using the checked-in Unicode 15.0 normalization tables."""

    combining, decomposition, composition = _normalization_tables()
    decomposed_value: list[int] = []
    for character in value:
        _decompose(ord(character), decomposition, decomposed_value)

    ordered: list[int] = []
    nonstarter_start = 0
    for codepoint in decomposed_value:
        if combining.get(codepoint, 0) == 0:
            if len(ordered) - nonstarter_start > 1:
                ordered[nonstarter_start:] = sorted(
                    ordered[nonstarter_start:],
                    key=lambda value: combining.get(value, 0),
                )
            ordered.append(codepoint)
            nonstarter_start = len(ordered)
        else:
            ordered.append(codepoint)
    if len(ordered) - nonstarter_start > 1:
        ordered[nonstarter_start:] = sorted(
            ordered[nonstarter_start:],
            key=lambda value: combining.get(value, 0),
        )
    if not ordered:
        return ""

    result = [ordered[0]]
    starter_position = 0
    starter = ordered[0]
    last_class = 0
    for codepoint in ordered[1:]:
        combining_class = combining.get(codepoint, 0)
        composite = _hangul_composition(starter, codepoint)
        if composite is None:
            composite = composition.get((starter, codepoint))
        if composite is not None and (last_class == 0 or last_class < combining_class):
            result[starter_position] = composite
            starter = composite
            continue
        if combining_class == 0:
            starter_position = len(result)
            starter = codepoint
        last_class = combining_class
        result.append(codepoint)
    return "".join(chr(codepoint) for codepoint in result)


__all__ = ["PINNED_UNICODE_VERSION", "pinned_unicode_15_nfc"]
